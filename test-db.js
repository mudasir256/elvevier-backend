const { MongoClient } = require("mongodb");

const MONGO_URI =
  "mongodb+srv://smudasir256_db_user:Dx0OsGHXzRU3dvdI@cluster0.fg93nqi.mongodb.net/?appName=Cluster0";

async function test() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db("elvevier");
  const orders = await db.collection("orders").find().sort({ createdAt: -1 }).limit(5).toArray();
  console.log(`\nFound ${orders.length} orders:\n`);
  orders.forEach((o) => {
    console.log(`  ID: ${o._id}`);
    console.log(`  Customer: ${o.deliveryAddress.firstName} ${o.deliveryAddress.lastName}`);
    console.log(`  Status: ${o.status}`);
    console.log(`  Total: Rs. ${o.total}`);
    console.log("");
  });
  await client.close();
}

test().catch(console.error);
