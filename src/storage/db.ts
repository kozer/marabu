import level from "level";
import { DEFAULT_DB_PATH } from "@/shared/constants";
import canonicalize from "canonicalize";

export interface DatabaseInterface {
  addObject(key: string, value: any): Promise<void>;
  validateObject(key: string, value: any): Promise<boolean>;
  getObject(key: string): Promise<any>;
}

class LevelDatabase implements DatabaseInterface {
  private db: ReturnType<typeof level>;

  constructor(path: string) {
    this.db = level(path || DEFAULT_DB_PATH);
  }

  async addObject(key: string, value: any): Promise<void> {
    const serialized = canonicalize(value);
    if (!serialized) {
      throw new Error("Failed to canonicalize object for storage");
    }

    await this.db.put(key, serialized);
  }

  async validateObject(key: string, value: any): Promise<boolean> {
    try {
      const storedValue = await this.db.get(key);
      if (!storedValue) return false;
      return storedValue === canonicalize(value);
    } catch (error) {
      return false;
    }
  }

  async getObject(key: string): Promise<any> {
    try {
      const storedValue = await this.db.get(key);
      if (!storedValue) return null;
      return JSON.parse(storedValue);
    } catch (error) {
      return null;
    }
  }
}

export default LevelDatabase;
