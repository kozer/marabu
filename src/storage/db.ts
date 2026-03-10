import level from "level";
import { DEFAULT_DB_PATH } from "@/shared/constants";
import canonicalize from "canonicalize";
import type { ObjectMessage } from "@/protocol/types";

export interface DatabaseInterface {
  putObject(key: string, value: ObjectMessage): Promise<void>;
  getObject(key: string): Promise<ObjectMessage | null>;
}

class LevelDatabase implements DatabaseInterface {
  private db: ReturnType<typeof level>;

  constructor(path: string) {
    this.db = level(path || DEFAULT_DB_PATH);
  }

  async putObject(key: string, value: ObjectMessage): Promise<void> {
    const serialized = canonicalize(value);
    if (!serialized) {
      throw new Error("Failed to canonicalize object for storage");
    }

    await this.db.put(key, serialized);
  }

  async getObject(key: string): Promise<ObjectMessage | null> {
    try {
      const storedValue = await this.db.get(key);
      if (!storedValue) return null;
      //This is already a canonicalized string, so we can parse it directly
      return JSON.parse(storedValue);
    } catch (error) {
      return null;
    }
  }
}

export default LevelDatabase;
