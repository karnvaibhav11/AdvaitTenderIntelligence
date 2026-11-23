"use client";

import { createContext, useContext } from "react";
import type { ProcurementApi } from "../shared/types";

export interface WorkspaceActions {
  api: ProcurementApi;
  /** Case currently open in the detail drawer, if any; used as TattvaAI context. */
  selectedCaseId: string | null;
  openCase(caseId: string): void;
  openVendor(vendorId: string): void;
  openDocument(documentId: string, page?: number): void;
  openRegister(drill: string): void;
  askTattva(question: string, caseId?: string): void;
}

const WorkspaceContext = createContext<WorkspaceActions | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceActions {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside ProcurementWorkspace");
  return value;
}
