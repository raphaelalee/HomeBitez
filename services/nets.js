// services/nets.js

const axios = require("axios");

const NETS_BASE = "https://sandbox.nets.openapipaas.com";
const NETS_ENQUIRY_URL_OVERRIDE = process.env.NETS_ENQUIRY_URL || null;
const NETS_ENQUIRY_URL =
  NETS_ENQUIRY_URL_OVERRIDE ||
  `${NETS_BASE}/api/v1/common/payments/nets-qr/enquiry`;
const NETS_ENQUIRY_URL_FALLBACK =
  process.env.NETS_ENQUIRY_URL_FALLBACK ||
  "https://uat-api.nets.com.sg:9065/NetsQR/uat/transactions/qr/enquiry";
const NETS_MID =
  process.env.NETS_MID ||
  process.env.NETS_MERCHANT_ID ||
  "1234567"; // sandbox-friendly default
const NETS_TIMEOUT_AS_SUCCESS =
  String(process.env.NETS_TIMEOUT_AS_SUCCESS || "").toLowerCase() === "true";

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

/**
 * Poll NETS for transaction status
 * @param {string|object} input - txnRetrievalRef string or object containing it
 * @returns {{status: 'SUCCESS'|'FAIL'|'PENDING', data: object}}
 */
async function checkStatus(input) {
  const ref =
    typeof input === "string"
      ? input
      : input?.txnRetrievalRef || input?.txn_retrieval_ref || input?.txnRef;

  if (!ref || !String(ref).trim()) {
    throw new Error("Missing txnRetrievalRef for NETS enquiry");
  }

  const body = {
    txn_retrieval_ref: String(ref),
    mid: NETS_MID,
  };

  async function postEnquiry(url) {
    return axios.post(url, body, {
      headers: {
        "api-key": API_KEY,
        "project-id": PROJECT_ID,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    });
  }

  let res;
  try {
    res = await postEnquiry(NETS_ENQUIRY_URL);
  } catch (err) {
    const status = err?.response?.status;
    const isTimeout =
      err?.code === "ECONNABORTED" ||
      /timeout/i.test(err?.message || "");

    // On timeout, default to PENDING so users are not auto-redirected to receipt.
    // Set NETS_TIMEOUT_AS_SUCCESS=true only if you explicitly want old behavior.
    if (isTimeout) {
      const status = NETS_TIMEOUT_AS_SUCCESS ? "SUCCESS" : "PENDING";
      console.warn(`NETS enquiry timed out; returning ${status} fallback`);
      return { status, data: { timeoutFallback: true } };
    }

    // Fallback if sandbox doesn't expose this path
    if (status === 404 && NETS_ENQUIRY_URL_FALLBACK) {
      try {
        res = await postEnquiry(NETS_ENQUIRY_URL_FALLBACK);
      } catch (err2) {
        const isTimeout2 =
          err2?.code === "ECONNABORTED" ||
          /timeout/i.test(err2?.message || "");
        if (isTimeout2) {
          const status = NETS_TIMEOUT_AS_SUCCESS ? "SUCCESS" : "PENDING";
          console.warn(`NETS enquiry (fallback) timed out; returning ${status} fallback`);
          return { status, data: { timeoutFallback: true, fallback: true } };
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  const data = res?.data?.result?.data || {};
  const responseCode = data.response_code;
  const statusNum = Number(data.txn_status);
  const statusRaw = data.txn_status;

  const success =
    responseCode === "00" &&
    (
      statusNum === 1 ||
      statusNum === 0 ||
      statusRaw === "1" ||
      statusRaw === "0" ||
      typeof statusRaw === "undefined" // some sandboxes omit txn_status but still mean success
    );
  const failed =
    Number.isFinite(statusNum) && statusNum !== 0 && statusNum !== 1;

  // Log the raw response for troubleshooting
  console.log("NETS enquiry response:", {
    responseCode,
    statusNum,
    statusRaw,
    data,
  });

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
