const express = require('express');
require("dotenv").config();   // Load environment variables
const path = require('path');

const app = express();

// Import DB connection
const db = require("./db");

// View engine + middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));



// Test DB connection
db.query("SELECT 1")
  .then(() => console.log("✅ Database connected successfully"))
  .catch(err => console.log("❌ Database connection error:", err));



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
