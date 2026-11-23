export interface QuestionGroup {
  title: string;
  questions: string[];
}

/** Starter questions per audience; shown in the chat. They are prompts for the model, not scripted answers. */
export const SAMPLE_QUESTIONS: QuestionGroup[] = [
  {
    title: "Executive",
    questions: [
      "What is the current procurement status across all departments?",
      "Which high-value tenders are delayed?",
      "How much procurement value is awaiting approval?",
      "Which departments have the highest procurement cycle time?",
      "Which risks should the CMD review first, and why?",
    ],
  },
  {
    title: "Tenders and bids",
    questions: [
      "Which tenders are closing in the next seven days?",
      "Show tenders that have received repeated corrigenda.",
      "Which tenders have only one bidder?",
      "Compare all bidders for tender TND-000123 and tell me who is L1.",
    ],
  },
  {
    title: "Contracts, delivery and vendors",
    questions: [
      "Which contracts are expiring in the next 60 days?",
      "Which vendors have repeated delivery delays?",
      "Compare the quality performance of the top five vendors by contract value.",
      "Identify procurement delays that may affect critical mine equipment availability.",
    ],
  },
  {
    title: "Finance and audit",
    questions: [
      "Which invoices are overdue, and what is outstanding by department?",
      "Which invoices do not reconcile with GRNs?",
      "Identify possible duplicate invoices.",
      "Show me procurement transactions with incomplete approval trails.",
    ],
  },
  {
    title: "Why and what next",
    questions: [
      "What are the major procurement bottlenecks and their underlying causes?",
      "Why has case ADV-DEMO-2026-000001 been delayed?",
      "Identify cases where approval delays are contributing to contract execution delays.",
    ],
  },
];
