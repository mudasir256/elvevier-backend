require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME;

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let db;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log("Connected to MongoDB");
}

// ─── Auth middleware ───
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Admin Login ───
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = jwt.sign({ email, role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, admin: { email, name: "Admin" } });
});

// ─── Verify token ───
app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ email: req.admin.email, name: "Admin", role: req.admin.role });
});

// ─── Checkout (public) ───
app.post("/api/checkout", async (req, res) => {
  try {
    const {
      email, firstName, lastName, address, apartment,
      city, state, postalCode, phone, orderItems, subtotal, shipping, total,
    } = req.body;

    if (!email || !firstName || !lastName || !address || !city || !phone) {
      return res.status(400).json({ error: "Please fill in all required fields." });
    }

    const order = {
      contact: { email },
      deliveryAddress: {
        firstName, lastName, address,
        apartment: apartment || "",
        city, state: state || "", postalCode: postalCode || "", phone,
      },
      orderItems: orderItems || [],
      subtotal,
      shipping: shipping || "Free",
      total,
      status: "pending",
      notes: [],
      createdAt: new Date(),
    };

    const result = await db.collection(COLLECTION_NAME).insertOne(order);
    res.status(201).json({ message: "Order placed successfully!", orderId: result.insertedId });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to place order. Please try again." });
  }
});

// ─── List orders (filter + search) ───
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (search) {
      filter.$or = [
        { "contact.email": { $regex: search, $options: "i" } },
        { "deliveryAddress.firstName": { $regex: search, $options: "i" } },
        { "deliveryAddress.lastName": { $regex: search, $options: "i" } },
        { "deliveryAddress.phone": { $regex: search, $options: "i" } },
        { "deliveryAddress.city": { $regex: search, $options: "i" } },
      ];
    }
    const orders = await db.collection(COLLECTION_NAME).find(filter).sort({ createdAt: -1 }).toArray();
    res.json(orders);
  } catch (err) {
    console.error("Fetch orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// ─── Dashboard stats ─── (BEFORE :id routes)
app.get("/api/orders/stats", requireAdmin, async (req, res) => {
  try {
    const col = db.collection(COLLECTION_NAME);
    const [totalOrders, statuses, revenueAgg] = await Promise.all([
      col.countDocuments(),
      col.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      col.aggregate([
        { $match: { status: { $ne: "cancelled" } } },
        { $group: { _id: null, revenue: { $sum: "$total" } } },
      ]).toArray(),
    ]);
    const statusCounts = {};
    statuses.forEach((s) => (statusCounts[s._id] = s.count));
    res.json({ totalOrders, revenue: revenueAgg[0]?.revenue || 0, statusCounts });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// ─── Export orders as CSV ─── (BEFORE :id routes)
app.get("/api/orders/export", requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    const orders = await db.collection(COLLECTION_NAME).find(filter).sort({ createdAt: -1 }).toArray();

    const header = "Order ID,Customer Name,Email,Phone,Address,City,State,Postal Code,Items,Subtotal,Shipping,Total,Status,Date\n";
    const rows = orders.map((o) => {
      const items = o.orderItems.map((i) => `${i.name} x${i.quantity}`).join(" | ");
      const d = new Date(o.createdAt).toISOString().split("T")[0];
      return [
        o._id,
        `${o.deliveryAddress.firstName} ${o.deliveryAddress.lastName}`,
        o.contact.email,
        o.deliveryAddress.phone,
        `"${o.deliveryAddress.address}"`,
        o.deliveryAddress.city,
        o.deliveryAddress.state || "",
        o.deliveryAddress.postalCode || "",
        `"${items}"`,
        o.subtotal, o.shipping, o.total, o.status, d,
      ].join(",");
    }).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=orders.csv");
    res.send(header + rows);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Failed to export orders." });
  }
});

// ─── Bulk update order statuses ─── (BEFORE :id routes)
app.patch("/api/orders/bulk-status", requireAdmin, async (req, res) => {
  try {
    const { orderIds, status } = req.body;
    const validStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "No orders selected." });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const ids = orderIds.map((id) => new ObjectId(id));
    const result = await db.collection(COLLECTION_NAME).updateMany(
      { _id: { $in: ids } },
      { $set: { status, updatedAt: new Date() } }
    );
    res.json({ message: `${result.modifiedCount} order(s) updated.`, modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error("Bulk status error:", err);
    res.status(500).json({ error: "Failed to update orders." });
  }
});

// ─── Single order detail ───
app.get("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const order = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json(order);
  } catch (err) {
    console.error("Fetch order error:", err);
    res.status(500).json({ error: "Failed to fetch order." });
  }
});

// ─── Update order status ───
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const result = await db.collection(COLLECTION_NAME).updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: "Order not found." });
    res.json({ message: "Status updated.", status });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: "Failed to update status." });
  }
});

// ─── Add admin note to order ───
app.post("/api/orders/:id/notes", requireAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) {
      return res.status(400).json({ error: "Note cannot be empty." });
    }
    const noteObj = { _id: new ObjectId(), text: note.trim(), createdAt: new Date() };
    const result = await db.collection(COLLECTION_NAME).updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { notes: noteObj }, $set: { updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: "Order not found." });
    res.status(201).json({ message: "Note added.", note: noteObj });
  } catch (err) {
    console.error("Add note error:", err);
    res.status(500).json({ error: "Failed to add note." });
  }
});

// ─── Delete a note from order ───
app.delete("/api/orders/:id/notes/:noteId", requireAdmin, async (req, res) => {
  try {
    const result = await db.collection(COLLECTION_NAME).updateOne(
      { _id: new ObjectId(req.params.id) },
      { $pull: { notes: { _id: new ObjectId(req.params.noteId) } } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: "Order not found." });
    res.json({ message: "Note deleted." });
  } catch (err) {
    console.error("Delete note error:", err);
    res.status(500).json({ error: "Failed to delete note." });
  }
});

// ─── Delete order ───
app.delete("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const result = await db.collection(COLLECTION_NAME).deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Order not found." });
    res.json({ message: "Order deleted." });
  } catch (err) {
    console.error("Delete order error:", err);
    res.status(500).json({ error: "Failed to delete order." });
  }
});

// ─── Customers list (aggregated from orders) ───
app.get("/api/customers", requireAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    const pipeline = [
      {
        $group: {
          _id: "$contact.email",
          firstName: { $first: "$deliveryAddress.firstName" },
          lastName: { $first: "$deliveryAddress.lastName" },
          phone: { $first: "$deliveryAddress.phone" },
          city: { $first: "$deliveryAddress.city" },
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: "$total" },
          lastOrder: { $max: "$createdAt" },
        },
      },
      { $sort: { lastOrder: -1 } },
    ];
    if (search) {
      pipeline.unshift({
        $match: {
          $or: [
            { "contact.email": { $regex: search, $options: "i" } },
            { "deliveryAddress.firstName": { $regex: search, $options: "i" } },
            { "deliveryAddress.lastName": { $regex: search, $options: "i" } },
            { "deliveryAddress.phone": { $regex: search, $options: "i" } },
          ],
        },
      });
    }
    const customers = await db.collection(COLLECTION_NAME).aggregate(pipeline).toArray();
    res.json(customers);
  } catch (err) {
    console.error("Customers error:", err);
    res.status(500).json({ error: "Failed to fetch customers." });
  }
});

// ─── Single customer detail with order history ───
app.get("/api/customers/:email", requireAdmin, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const orders = await db.collection(COLLECTION_NAME).find({ "contact.email": email }).sort({ createdAt: -1 }).toArray();
    if (orders.length === 0) return res.status(404).json({ error: "Customer not found." });
    const customer = {
      email,
      firstName: orders[0].deliveryAddress.firstName,
      lastName: orders[0].deliveryAddress.lastName,
      phone: orders[0].deliveryAddress.phone,
      address: orders[0].deliveryAddress.address,
      city: orders[0].deliveryAddress.city,
      state: orders[0].deliveryAddress.state,
      postalCode: orders[0].deliveryAddress.postalCode,
      totalOrders: orders.length,
      totalSpent: orders.reduce((sum, o) => sum + (o.total || 0), 0),
      orders,
    };
    res.json(customer);
  } catch (err) {
    console.error("Customer detail error:", err);
    res.status(500).json({ error: "Failed to fetch customer." });
  }
});

// ─── Revenue analytics (daily for last 30 days) ───
app.get("/api/analytics/revenue", requireAdmin, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const daily = await db.collection(COLLECTION_NAME).aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: "cancelled" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    const topProducts = await db.collection(COLLECTION_NAME).aggregate([
      { $match: { status: { $ne: "cancelled" } } },
      { $unwind: "$orderItems" },
      { $group: { _id: "$orderItems.name", totalQty: { $sum: "$orderItems.quantity" }, totalRevenue: { $sum: { $multiply: ["$orderItems.price", "$orderItems.quantity"] } } } },
      { $sort: { totalQty: -1 } },
      { $limit: 10 },
    ]).toArray();

    const topCities = await db.collection(COLLECTION_NAME).aggregate([
      { $match: { status: { $ne: "cancelled" } } },
      { $group: { _id: "$deliveryAddress.city", orders: { $sum: 1 }, revenue: { $sum: "$total" } } },
      { $sort: { orders: -1 } },
      { $limit: 10 },
    ]).toArray();

    res.json({ daily, topProducts, topCities });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: "Failed to fetch analytics." });
  }
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
