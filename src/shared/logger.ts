import pino from "pino";
import { join } from "path";

// const logger = pino({
//   transport: {
//     target: "pino-pretty",
//     options: {
//       colorize: true,
//     },
//   },
//   level: process.env.LOG_LEVEL || "info",
// });
const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
  },
  pino.multistream([
    {
      stream: pino.destination(`${process.cwd()}/logs/node.log`),
    },
    {
      level: "info",
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true },
      }),
    },
  ]),
);

export default logger;
