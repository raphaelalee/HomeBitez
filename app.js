const express = require('express');
require("dotenv").config();   // Load environment variables

const app = express();

// Import DB connection
const db = require("./db");

// Test DB connection
db.query("SELECT 1")
  .then(() => console.log("✅ Database connected successfully"))
  .catch(err => console.log("❌ Database connection error:", err));

app.get('/', (req, res) => {
   res.send("Hello World!")
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

//hello jeffery jeffery

//hi 

//marcus 

//marcus 1

//bye

//hello raphaela 
//hello marla
// test push from Raphaela

//test push from Marla

// another test push from Marla
// test try wk
// test try wk 2.0
// test try wk 3.0
