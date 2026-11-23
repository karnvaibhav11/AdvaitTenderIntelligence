import { existsSync } from "node:fs";
import { getStore } from "../db";

/**
 * Connector contract for external systems. Each connector reports its real
 * state; nothing is claimed as live unless a connector actually is. Every
 * record in the product carries provenance so imported, manual and synthetic
 * data are never confused.
 */
export type Provenance =
  | "official_api_sync"
  | "authorized_file_import"
  | "manual_upload"
  | "internal_enterprise_system"
  | "synthetic_demonstration";

export interface ConnectorStatus {
  id: string;
  name: string;
  kind: "gem" | "erp" | "eoffice" | "dms" | "file_import" | "database" | "inspection";
  state: "not_configured" | "connected" | "error";
  provenance: Provenance | null;
  detail: string;
  lastSync: string | null;
  records: number | null;
}

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectorStatus["kind"];
  status(): ConnectorStatus;
}

const notConfigured = (id: string, name: string, kind: ConnectorStatus["kind"], detail: string): Connector => ({
  id,
  name,
  kind,
  status: () => ({ id, name, kind, state: "not_configured", provenance: null, detail, lastSync: null, records: null }),
});

const syntheticDataset: Connector = {
  id: "synthetic-dataset",
  name: "Synthetic procurement dataset (CSV and PDF)",
  kind: "file_import",
  status() {
    const store = getStore();
    const present = existsSync(store.dataDir);
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      state: present ? "connected" : "error",
      provenance: "synthetic_demonstration",
      detail: present ? `Loaded ${store.tables.length} tables from ${store.dataDir}. All records are synthetic.` : `Dataset directory not found: ${store.dataDir}`,
      lastSync: null,
      records: present ? store.tables.length : null,
    };
  },
};

const registry: Connector[] = [
  syntheticDataset,
  notConfigured("gem", "GeM (Government e-Marketplace)", "gem", "No authorised GeM API access or export is configured. This product does not claim live GeM integration."),
  notConfigured("sap", "SAP / ERP", "erp", "No SAP or ERP connector is configured. Implement the Connector contract against an authorised interface."),
  notConfigured("eoffice", "e-Office", "eoffice", "No e-Office connector is configured."),
  notConfigured("dms", "Document management system", "dms", "No external document repository is configured; documents come from the loaded dataset."),
  notConfigured("inspection", "Inspection systems", "inspection", "No inspection-system connector is configured."),
];

export function registerConnector(connector: Connector): void {
  const index = registry.findIndex((c) => c.id === connector.id);
  if (index >= 0) registry[index] = connector;
  else registry.push(connector);
}

export function getConnectorStatuses(): ConnectorStatus[] {
  return registry.map((connector) => connector.status());
}
