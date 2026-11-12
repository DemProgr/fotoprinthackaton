"use strict";
// Netlify Functions entry point (AWS Lambda event format).
// Adapts the Lambda (event, context) into Node-style req/res for the shared handle() in server/index.js.
const { handle } = require("../server/index.js");
const { PassThrough } = require("stream");

function bodyBuffer(event) {
  if (!event.body) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

module.exports.handler = async function (event, context) {
  const rawQuery = event.rawQueryString || event.rawQuery || "";
  let apiPath = event.path || "/";
  // Support direct invocations of /.netlify/functions/index?__path=...
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
};
