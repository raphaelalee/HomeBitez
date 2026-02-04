// services/nets.js
const axios = require("axios");

const NETS_BASE = "https://sandbox.nets.openapipaas.com";
const NETS_REQUEST_URL = `${NETS_BASE}/api/v1/common/payments/nets-qr/request`;
const NETS_ENQUIRY_URL =
  process.env.NETS_ENQUIRY_URL ||
  `${NETS_BASE}/api/v1/common/payments/nets-qr/query`;

const API_KEY = process.env.API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const NETS_MID = process.env.NETS_MID || process.env.NETS_MERCHANT_ID || "";

function mustHaveEnv(name, value) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

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

  const body = {
    txn_id: String(txnId),
    amt_in_dollars: Number(amt.toFixed(2)),
    notify_mobile: 0,
  };

  const res = await axios.post(NETS_REQUEST_URL, body, {
    headers: {
      "api-key": API_KEY,
      "project-id": PROJECT_ID,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  const qrData = res?.data?.result?.data;
  if (!qrData) {
    throw new Error(`Unexpected NETS response: ${JSON.stringify(res.data)}`);
  }

  return qrData;
}

function isQrSuccess(qrData) {
  return (
    qrData?.response_code === "00" &&
    Number(qrData?.txn_status) === 1 &&
    !!qrData?.qr_code &&
    !!qrData?.txn_retrieval_ref
  );
}

/**
 * Poll NETS for transaction status
 * @param {string} txnRetrievalRef
 * @returns {{status: 'SUCCESS'|'FAIL'|'PENDING', data: object}}
 */
async function checkStatus(txnRetrievalRef) {
  if (!txnRetrievalRef || !String(txnRetrievalRef).trim()) {
    throw new Error("Missing txnRetrievalRef for NETS enquiry");
  }

  const body = {
    txn_retrieval_ref: String(txnRetrievalRef),
  };
  if (NETS_MID) body.mid = NETS_MID;

  const res = await axios.post(NETS_ENQUIRY_URL, body, {
    headers: {
      "api-key": API_KEY,
      "project-id": PROJECT_ID,
      "Content-Type": "application/json",
    },
    timeout: 8000,
  });

  const data = res?.data?.result?.data || {};
  const responseCode = data.response_code;
  const statusNum = Number(data.txn_status);
  const statusRaw = data.txn_status;

  const success =
    responseCode === "00" &&
    (statusNum === 1 ||
      statusNum === 0 ||
      statusRaw === "1" ||
      statusRaw === "0" ||
      typeof statusRaw === "undefined");
  const failed = Number.isFinite(statusNum) && statusNum !== 0 && statusNum !== 1;

  return {
    status: success ? "SUCCESS" : failed ? "FAIL" : "PENDING",
    data,
  };
}

module.exports = {
  requestNetsQr,
  isQrSuccess,
  checkStatus,
};
