import {
  QUEUE_DELAY_PER_BATCH_MS,
  REQUEST_BATCH_SIZE,
} from "@/shared/constants";
import type pino from "pino";

class RequestQueue {
  private queue: {
    id: string;
    broadcastFn: (id: string) => void;
  }[] = [];

  constructor(private log: pino.Logger) {}

  private processing = false;

  add(id: string, broadcastFn: (id: string) => void) {
    this.queue.push({ id, broadcastFn });
    if (!this.processing) {
      this.process();
    }
  }

  private async process() {
    this.processing = true;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, REQUEST_BATCH_SIZE);
      for (const { id, broadcastFn } of batch) {
        try {
          broadcastFn(id);
        } catch (err) {
          this.log.error(
            `Error broadcasting request for ${id}: ${(err as Error).message}`,
          );
        }
      }
      if (this.queue.length > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, QUEUE_DELAY_PER_BATCH_MS),
        );
      }
    }
    this.processing = false;
  }
}

export default RequestQueue;
