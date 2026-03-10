declare module "level" {
  interface LevelDb {
    put(key: string, value: string): Promise<void>;
    get(key: string): Promise<string>;
    del(key: string): Promise<void>;
  }

  export default function level(path: string): LevelDb;
}
