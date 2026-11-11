"use strict";
// Точка входа бессерверной функции Vercel: весь REST API обслуживает общий обработчик.
const { handle } = require("../server/index.js");
module.exports = (req, res) => handle(req, res);
