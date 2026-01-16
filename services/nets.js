// services/nets.js

const axios = require("axios");

const NETS_BASE = "https://sandbox.nets.openapipaas.com";

function mustHaveEnv(name, value) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

// Expected env vars
const API_KEY = process.env.API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;

mustHaveEnv("API_KEY", API_KEY);
mustHaveEnv("PROJECT_ID", PROJECT_ID);

/**
 * Create NETS QR request (Sandbox)
 * @param {number|string} amount - total amount in dollars, e.g. 12.00
 * @param {string} txnId - sandbox txn_id string (required by NETS sandbox)
 * @returns {object} - { qr_code, txn_retrieval_ref, response_code, txn_status, ... }
 */
async function requestNetsQr(amount, txnId) {
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error(`Invalid amount for NETS QR: ${amount}`);
  }

  if (!txnId || !String(txnId).trim()) {
    throw new Error("Missing txnId for NETS QR request");
  }

  // NETS sandbox expects specific body keys
  const body = {
    txn_id: String(txnId),
    amt_in_dollars: Number(amt.toFixed(2)),
    notify_mobile: 0,
  };

  const url = `${NETS_BASE}/api/v1/common/payments/nets-qr/request`;

  const res = await axios.post(url, body, {
    headers: {
      "api-key": API_KEY,
      "project-id": PROJECT_ID,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  // res.data structure usually like: { result: { data: {...} } }
  const qrData = res?.data?.result?.data;

  if (!qrData) {
    throw new Error(`Unexpected NETS response: ${JSON.stringify(res.data)}`);
  }

  return qrData;
}

/**
 * Helper: Validate NETS "success" for QR creation
 */
function isQrSuccess(qrData) {
  // Based on NETS sandbox examples:
  // response_code: "00" (success)
  // txn_status: 1
  // qr_code: base64 png string
  return (
    qrData.response_code === "00" &&
    Number(qrData.txn_status) === 1 &&
    !!qrData.qr_code &&
    !!qrData.txn_retrieval_ref
  );
}

module.exports = {
  requestNetsQr,
  isQrSuccess,
};
