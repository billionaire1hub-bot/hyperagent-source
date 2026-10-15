import * as path from "path";
import { config } from "../config";
import { JsonCollection } from "./collection";
import type {
  A2ATask,
  LedgerEntry,
  Negotiation,
  PeerAgent,
  WalletBalance,
} from "../types";

const dir = path.isAbsolute(config.storage.dataDir)
  ? config.storage.dataDir
  : path.join(process.cwd(), config.storage.dataDir);

const file = (name: string) => path.join(dir, `${name}.json`);

/**
 * Process-wide store. A single instance is shared by the API server and all
 * background workers so they observe each other's writes immediately.
 */
class Store {
  readonly peers = new JsonCollection<PeerAgent>(file("peers"));
  readonly tasks = new JsonCollection<A2ATask>(file("tasks"));
  readonly negotiations = new JsonCollection<Negotiation>(file("negotiations"));
  readonly ledger = new JsonCollection<LedgerEntry>(file("ledger"));
  readonly balances = new JsonCollection<WalletBalance>(file("balances"));
  readonly processedEvents = new JsonCollection<{ id: string; at: string }>(
    file("processed_events"),
  );

  readonly dataDir = dir;
}

export const store = new Store();
export type { Store };
