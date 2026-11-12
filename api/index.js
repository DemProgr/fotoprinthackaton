"use strict";
// Универсальный обработчик API: работает и на Vercel (@vercel/node, (req, res)),
// и на Netlify Functions (AWS Lambda, (event, context)).
const { handle } = require("../server/index.js");
const { PassThrough } = require("stream");

function bodyBuffer(event) {
  if (!event.body) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

function isNetlifyEvent(arg) {
  return Boolean(arg && arg.httpMethod && arg.path !== undefined);
}

async function runNetlify(event, context) {
  const rawQuery = event.rawQueryString || event.rawQuery || "";
  let apiPath = event.path || "/";
  if (apiPath.startsWith("/.netlify/functions/")) {
    const qp = new URLSearchParams(rawQuery);
    const p = qp.get("__path");
    if (p) apiPath = "/api/" + p;
  }
  const url = "http://localhost" + apiPath + (rawQuery ? "?" + rawQuery : "");

  const buf = bodyBuffer(event);
  const stream = new PassThrough();
  if (buf) stream.end(buf); else stream.end();

  const req = Object.assign(stream, {
    url,
    method: (event.httpMethod || "GET").toUpperCase(),
    headers: event.headers || {},
    socket: { remoteAddress: event.headers["x-forwarded-for"] || event.headers["client-ip"] || "127.0.0.1" },
  });

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  let statusCode = 200;
  const headers = {};
  let body = "";
  const res = {
    writeHead(status, headersObj) {
      statusCode = status;
      Object.assign(headers, headersObj);
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    end(chunk) {
      body = chunk == null ? "" : typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    },
  };

  try {
    await handle(req, res);
  } catch (err) {
    console.error(err);
    if (statusCode === 200) statusCode = 500;
  }

  return {
    statusCode,
    headers: { ...cors, ...headers, "Content-Type": headers["Content-Type"] || "application/json; charset=utf-8" },
    body,
  };
}

async function handler(a, b) {
  if (isNetlifyEvent(a)) return runNetlify(a, b);
  // Vercel: (req, res) — handle() уже умеет работать с нативными объектами http.
  return handle(a, b);
}

module.exports = handler;
module.exports.handler = handler;
