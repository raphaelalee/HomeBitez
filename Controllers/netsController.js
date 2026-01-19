// controllers/NetsController.js
const nets = require("../services/nets");

// Render the NETS QR page
exports.renderNetsQr = async (req, res) => {
  try {
    // server-calc total from session cart
    const cart = req.session.cart || [];
    if (!cart.length) return res.redirect("/cart");

    const subtotal = cart.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
      0
    );

    const deliveryFee = 2.5;
    const amount = Number((subtotal + deliveryFee).toFixed(2));

    // create NETS QR transaction
    const txnRef = `HBZ-${Date.now()}`;

    // Expect nets.createQr to return:
    // { qrCodeUrl, txnRetrievalRef }
    const result = await nets.createQr({ amount, txnRef });

    // store in session so SSE can validate
    req.session.netsPending = {
      txnRef,
      txnRetrievalRef: result.txnRetrievalRef,
      amount,
      createdAt: Date.now(),
    };

    return res.render("netsQR", {
      qrCodeUrl: result.qrCodeUrl,
      txnRetrievalRef: result.txnRetrievalRef,
      amount,
      timeRemaining: "5:00",
    });
  } catch (err) {
    console.error("renderNetsQr error:", err);
    return res.redirect("/checkout");
  }
};

// SSE stream: keep connection open, poll NETS status
exports.ssePaymentStatus = async (req, res) => {
  const { txnRetrievalRef } = req.params;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // quick validation against session
  const pending = req.session.netsPending;
  if (!pending || pending.txnRetrievalRef !== txnRetrievalRef) {
    res.write(`data: ${JSON.stringify({ fail: true, message: "Invalid session / reference" })}\n\n`);
    return res.end();
  }

  let closed = false;
  req.on("close", () => { closed = true; });

  // poll every 5 seconds (matches your UI text)
  const interval = setInterval(async () => {
    if (closed) {
      clearInterval(interval);
      return;
    }

    try {
      const status = await nets.checkStatus({ txnRetrievalRef });

      // You MUST map these to your real NETS status codes
      if (status === "SUCCESS") {
        res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
        clearInterval(interval);
        return res.end();
      }

      if (status === "FAILED") {
        res.write(`data: ${JSON.stringify({ fail: true, message: "Payment failed" })}\n\n`);
        clearInterval(interval);
        return res.end();
      }

      // still pending → do nothing, keep connection open
    } catch (err) {
      console.error("sse status poll error:", err);
      // keep waiting, don’t kill SSE immediately
    }
  }, 5000);
};

exports.netsSuccess = (req, res) => {
  res.render("netsSuccess"); // create a simple page, or redirect
};

exports.netsFail = (req, res) => {
  res.render("netsFail"); // create a simple page, or redirect
};
