import level from "level-ts";
import { DEFAULT_DB_PATH } from "./constants";
import canonicalize from "canonicalize";

export interface DatabaseInterface {
  addObject(key: string, value: any): Promise<void>;
  validateObject(key: string, value: any): Promise<boolean>;
  getObject(key: string): Promise<any>;
}

class LevelDatabase implements DatabaseInterface {
  private db: level;
  constructor(path: string) {
    this.db = new level(path || DEFAULT_DB_PATH);
  }
  async addObject(key: string, value: any): Promise<void> {
    return this.db.put(key, canonicalize(value));
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
