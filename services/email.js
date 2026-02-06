/*
I declare that this code was written by me.
I will not copy or allow others to copy my code.
I understand that copying code is considered as plagiarism.

Student Name: Jeffery
Student ID: 24016580 
Class: E63C c004
Date created: February 3, 2026
*/
const nodemailer = require('nodemailer');

const gmailUserRaw = process.env.GMAIL_USER || '';
const gmailPassRaw = process.env.GMAIL_APP_PASSWORD || '';
const gmailUser = gmailUserRaw.trim();
const gmailPass = gmailPassRaw.trim();

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
  const info = await tx.sendMail({
    from: `HomeBitez <${gmailUser}>`,
    to,
    subject,
    text
  });
  return info;
}

module.exports = { sendEmail };
