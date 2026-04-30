import pino from "pino";

const logger = pino(
  {
    enabled: !process.env.NOLOG,
    level: process.env.LOG_LEVEL || "info",
  },
  pino.multistream([
    {
      stream: pino.destination(`${process.cwd()}/logs/node.log`),
    },
    {
      level: process.env.LOG_LEVEL || "info",
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true, ignore: "pid", levelFirst: true },
      }),
    },
  ]),
);

export default logger;
