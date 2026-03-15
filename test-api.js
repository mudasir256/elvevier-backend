const http = require("http");

function testEndpoint(path) {
  return new Promise((resolve) => {
    http.get(`http://localhost:4000${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ path, status: res.statusCode, body: data.substring(0, 300) });
      });
    }).on("error", (err) => {
      resolve({ path, error: err.message });
    });
  });
}

(async () => {
  const listResult = await testEndpoint("/api/orders");
  console.log("=== GET /api/orders ===");
  console.log("Status:", listResult.status);
  
  if (listResult.error) {
    console.log("Error:", listResult.error);
    process.exit(1);
  }

  const orders = JSON.parse(listResult.body.length > 0 ? listResult.body : "[]");
  console.log("Orders count (from partial):", Array.isArray(orders) ? orders.length : "not array");
  
  if (Array.isArray(orders) && orders.length > 0) {
    const firstId = orders[0]._id;
    console.log("\nFirst order _id:", firstId);
    
    const detailResult = await testEndpoint(`/api/orders/${firstId}`);
    console.log("\n=== GET /api/orders/" + firstId + " ===");
    console.log("Status:", detailResult.status);
    console.log("Body:", detailResult.body);
  } else {
    console.log("No orders found in database!");
  }
})();
