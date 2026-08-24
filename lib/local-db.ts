import Dexie, { type EntityTable } from 'dexie';

type LocalRecord = {
  key: string;
  value: unknown;
  updatedAt: string;
};

const database = new Dexie('darj-local-v2') as Dexie & {
  records: EntityTable<LocalRecord, 'key'>;
};

database.version(1).stores({ records: '&key, updatedAt' });

export async function localGet<T>(key: string): Promise<T | null> {
  const record = await database.records.get(key);
  return (record?.value as T | undefined) ?? null;
}

export async function localPut(key: string, value: unknown): Promise<void> {
  await database.records.put({ key, value, updatedAt: new Date().toISOString() });
}

export async function localDelete(key: string): Promise<void> {
  await database.records.delete(key);
}

export async function localStorageAvailable(): Promise<boolean> {
  const key = 'healthcheck';
  try {
    await localPut(key, true);
    await localDelete(key);
    return true;
  } catch {
    return false;
  }
}

