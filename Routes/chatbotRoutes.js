const express = require("express");
const router = express.Router();
const chatbotController = require("../Controllers/chatbotController");

router.post("/chatbot/ask", chatbotController.ask);

module.exports = router;
