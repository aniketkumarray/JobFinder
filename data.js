/* ============================================================
   AutoMatch AI — data
   Jobs come from live search and imports; the resume starts empty until you
   upload or edit yours in Settings.
   ============================================================ */

window.AUTOMATCH_JOBS = [];

window.AUTOMATCH_DEFAULT_RESUME = {
  name: "",
  title: "",
  email: "",
  phone: "",
  location: "",
  website: "",
  summary: "",
  experience: [],
  skills: [],
  education: [],
  certifications: [],
};

window.AUTOMATCH_KEYWORDS = [
  { label: "Product Strategy", terms: ["product strategy", "product vision", "vision"] },
  { label: "Roadmapping", terms: ["roadmap", "roadmapping"] },
  { label: "A/B Testing", terms: ["a/b test", "a/b testing", "split test"] },
  { label: "Experimentation", terms: ["experimentation", "experiment"] },
  { label: "SQL", terms: ["sql"] },
  { label: "Python", terms: ["python"] },
  { label: "Mixpanel", terms: ["mixpanel"] },
  { label: "Amplitude", terms: ["amplitude"] },
  { label: "Looker", terms: ["looker"] },
  { label: "Tableau", terms: ["tableau"] },
  { label: "Excel", terms: ["excel"] },
  { label: "Dashboarding", terms: ["dashboard", "dashboarding"] },
  { label: "Funnel Analysis", terms: ["funnel", "funnel analysis"] },
  { label: "Retention", terms: ["retention", "retain"] },
  { label: "Growth Loops", terms: ["growth loop", "growth loops", "growth"] },
  { label: "Referrals", terms: ["referral", "referrals"] },
  { label: "User Research", terms: ["user research", "customer research", "customer discovery"] },
  { label: "Personalization", terms: ["personalization", "personalisation", "recommendation"] },
  { label: "Stakeholder Management", terms: ["stakeholder"] },
  { label: "Team Leadership", terms: ["lead a team", "lead pm", "team leadership", "mentor", "leading other"] },
  { label: "Cross-functional", terms: ["cross-functional", "cross functional"] },
  { label: "Compliance", terms: ["compliance", "rbi"] },
  { label: "Fintech", terms: ["fintech", "lending", "credit", "payments"] },
  { label: "EdTech", terms: ["edtech", "education", "learning"] },
  { label: "Ecommerce", terms: ["ecommerce", "marketplace", "supply-chain"] },
  { label: "Consumer", terms: ["consumer"] },
  { label: "SaaS", terms: ["saas", "subscription"] },
  { label: "APIs", terms: ["api", "apis", "developer platform"] },
  { label: "Developer Experience", terms: ["developer experience", "developer support"] },
  { label: "Payments", terms: ["payment", "payments"] },
  { label: "LLM", terms: ["llm", "llms", "foundation model"] },
  { label: "Prompt Engineering", terms: ["prompt engineering", "prompt"] },
  { label: "Evals", terms: ["eval", "evals", "evaluation suite", "evaluations"] },
  { label: "Forecasting", terms: ["forecast", "forecasting"] },
  { label: "Data Storytelling", terms: ["data storytelling", "data story", "communicate findings"] },
  { label: "Communication", terms: ["communication", "written"] },
  { label: "Analytics", terms: ["analytics", "analysis"] },
  { label: "Jira", terms: ["jira"] },
  { label: "Figma", terms: ["figma"] },
  { label: "Requirements Gathering", terms: ["requirements gathering", "gather requirements"] },
  { label: "Salesforce", terms: ["salesforce"] },
  { label: "Process Mapping", terms: ["process mapping", "map processes"] },
  { label: "Documentation", terms: ["documentation", "document"] },
];
