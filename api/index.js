"use strict";
// Бессерверная функция Vercel (@vercel/node): обработчик (req, res) из server/index.js.
// Запросы /api/* приходят сюда с исходным путём в ?__path (см. rewrites в vercel.json).
const { handle } = require("../server/index.js");

module.exports = (req, res) => handle(req, res);
