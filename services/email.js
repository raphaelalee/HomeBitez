const nodemailer = require('nodemailer');

const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_APP_PASSWORD;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!gmailUser || !gmailPass) {
    throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
  });
  return transporter;
}

async function sendEmail({ to, subject, text }) {
  if (!to) throw new Error('Missing recipient email');
  const tx = getTransporter();
  await tx.sendMail({
    from: `HomeBitez <${gmailUser}>`,
    to,
    subject,
    text
  });
}

module.exports = { sendEmail };
