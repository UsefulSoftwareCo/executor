// Shared mock data for viewer prototypes: two real runs + one synthetic failure.
// Each run has assetBase — prefix evidence paths with it (screenshots/video).
window.E2E_DATA = {
 "runs": [
  {
   "schema": 2,
   "scenario": "Billing \u00b7 the free plan stops organization creation after 3",
   "target": "cloud",
   "brain": "scripted",
   "ok": true,
   "startedAt": 1781044993358,
   "meta": {
    "baseUrl": "http://127.0.0.1:4798"
   },
   "turns": [
    {
     "t": 1781044993358,
     "role": "user",
     "text": "Billing \u00b7 the free plan stops organization creation after 3"
    },
    {
     "t": 1781044993358,
     "role": "assistant",
     "kind": "reasoning",
     "text": "A fresh user creates organizations through the web UI until the free plan refuses \u2014 expecting 3 to succeed and the 4th to be blocked."
    },
    {
     "t": 1781044993988,
     "role": "step",
     "surface": "browser",
     "text": "Opened http://127.0.0.1:4798 as user_fcac1b81 (dark, 1280\u00d7800)"
    },
    {
     "t": 1781044999794,
     "role": "step",
     "surface": "browser",
     "text": "A fresh user lands on onboarding (no organization yet)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "01-a-fresh-user-lands-on-onboarding-no-organization-yet.png",
       "label": "A fresh user lands on onboarding (no organization yet)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 1,
       "endMs": 5807
      }
     ]
    },
    {
     "t": 1781045000249,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 1\u201d (1 of 3 allowed on the free plan)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "02-create-acme-1-1-of-3-allowed-on-the-free-plan.png",
       "label": "Create \u201cAcme 1\u201d (1 of 3 allowed on the free plan)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 5807,
       "endMs": 6262
      }
     ]
    },
    {
     "t": 1781045000681,
     "role": "step",
     "surface": "browser",
     "text": "Continue into the app",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "03-continue-into-the-app.png",
       "label": "Continue into the app"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 6262,
       "endMs": 6694
      }
     ]
    },
    {
     "t": 1781045001298,
     "role": "step",
     "surface": "browser",
     "text": "Open the org switcher and choose \u201cCreate organization\u201d",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "04-open-the-org-switcher-and-choose-create-organization.png",
       "label": "Open the org switcher and choose \u201cCreate organization\u201d"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 6694,
       "endMs": 7310
      }
     ]
    },
    {
     "t": 1781045002125,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 2\u201d (2 of 3)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "05-create-acme-2-2-of-3.png",
       "label": "Create \u201cAcme 2\u201d (2 of 3)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 7311,
       "endMs": 8138
      }
     ]
    },
    {
     "t": 1781045002596,
     "role": "step",
     "surface": "browser",
     "text": "Open the org switcher and choose \u201cCreate organization\u201d",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "06-open-the-org-switcher-and-choose-create-organization.png",
       "label": "Open the org switcher and choose \u201cCreate organization\u201d"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 8138,
       "endMs": 8609
      }
     ]
    },
    {
     "t": 1781045003368,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 3\u201d (3 of 3)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "07-create-acme-3-3-of-3.png",
       "label": "Create \u201cAcme 3\u201d (3 of 3)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 8609,
       "endMs": 9381
      }
     ]
    },
    {
     "t": 1781045004290,
     "role": "step",
     "surface": "browser",
     "text": "Attempt a 4th organization (over the free limit)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "08-attempt-a-4th-organization-over-the-free-limit.png",
       "label": "Attempt a 4th organization (over the free limit)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 9381,
       "endMs": 10303
      }
     ]
    },
    {
     "t": 1781045004293,
     "role": "assert",
     "assertion": {
      "kind": "toBeGreaterThan",
      "actual": 30,
      "expected": 0,
      "ok": true,
      "label": "the UI shows a visible refusal"
     }
    },
    {
     "t": 1781045004293,
     "role": "step",
     "surface": "browser",
     "text": "The 4th create is refused: \u201cFailed to create organization.\u201d"
    },
    {
     "t": 1781045004307,
     "role": "tool",
     "surface": "api",
     "call": {
      "name": "auth.organizations",
      "args": {}
     },
     "result": {
      "organizations": [
       {
        "id": "org_created_10",
        "name": "org_created_10"
       },
       {
        "id": "org_created_11",
        "name": "org_created_11"
       },
       {
        "id": "org_created_13",
        "name": "org_created_13"
       }
      ],
      "activeOrganizationId": "org_created_13"
     },
     "ok": true,
     "text": "org_created_10, org_created_11, org_created_13"
    },
    {
     "t": 1781045004307,
     "role": "assert",
     "assertion": {
      "kind": "toBe",
      "actual": 3,
      "expected": 3,
      "ok": true,
      "label": "exactly the free-plan allowance exists"
     }
    },
    {
     "t": 1781045004681,
     "role": "step",
     "surface": "browser",
     "text": "Full session recording",
     "evidence": [
      {
       "kind": "video",
       "path": "00-session.mp4"
      }
     ]
    }
   ],
   "asserts": [
    {
     "kind": "toBeGreaterThan",
     "actual": 30,
     "expected": 0,
     "ok": true,
     "label": "the UI shows a visible refusal"
    },
    {
     "kind": "toBe",
     "actual": 3,
     "expected": 3,
     "ok": true,
     "label": "exactly the free-plan allowance exists"
    }
   ],
   "endedAt": 1781045004681,
   "durationMs": 11323,
   "assetBase": "../cloud/billing-the-free-plan-stops-organization-creation-after-3/"
  },
  {
   "schema": 2,
   "scenario": "MCP \u00b7 OAuth connect, then execute code in the sandbox",
   "target": "selfhost",
   "brain": "scripted",
   "ok": true,
   "startedAt": 1781045010033,
   "meta": {
    "baseUrl": "http://localhost:4799"
   },
   "turns": [
    {
     "t": 1781045010033,
     "role": "user",
     "text": "MCP \u00b7 OAuth connect, then execute code in the sandbox"
    },
    {
     "t": 1781045010033,
     "role": "assistant",
     "kind": "reasoning",
     "text": "Connect an MCP client (headless OAuth) and confirm the sandbox evaluates code."
    },
    {
     "t": 1781045010033,
     "role": "auth",
     "phase": "connect",
     "text": "Connecting to http://localhost:4799/mcp"
    },
    {
     "t": 1781045010089,
     "role": "auth",
     "phase": "connected",
     "text": "Connected \u2014 access token acquired & cached for reuse",
     "ok": true
    },
    {
     "t": 1781045010089,
     "role": "tool",
     "surface": "mcp",
     "call": {
      "name": "tools/list",
      "args": {}
     },
     "result": [
      "execute",
      "resume"
     ],
     "ok": true,
     "text": "execute, resume"
    },
    {
     "t": 1781045010089,
     "role": "assert",
     "assertion": {
      "kind": "toContain",
      "actual": [
       "execute",
       "resume"
      ],
      "expected": "execute",
      "ok": true,
      "label": "the execute tool is advertised"
     }
    },
    {
     "t": 1781045010094,
     "role": "tool",
     "surface": "mcp",
     "call": {
      "name": "execute",
      "args": {
       "code": "return 6 * 7;"
      }
     },
     "result": [
      {
       "type": "text",
       "text": "42"
      }
     ],
     "ok": true,
     "text": "42",
     "durationMs": 5
    },
    {
     "t": 1781045010094,
     "role": "assert",
     "assertion": {
      "kind": "toBe",
      "actual": "42",
      "expected": "42",
      "ok": true,
      "label": "the sandbox returns the value"
     }
    }
   ],
   "asserts": [
    {
     "kind": "toContain",
     "actual": [
      "execute",
      "resume"
     ],
     "expected": "execute",
     "ok": true,
     "label": "the execute tool is advertised"
    },
    {
     "kind": "toBe",
     "actual": "42",
     "expected": "42",
     "ok": true,
     "label": "the sandbox returns the value"
    }
   ],
   "endedAt": 1781045010094,
   "durationMs": 61,
   "assetBase": "../selfhost/mcp-oauth-connect-then-execute-code-in-the-sandbox/"
  },
  {
   "schema": 2,
   "scenario": "Billing \u00b7 paid plan upgrade unlocks a 4th organization",
   "target": "cloud",
   "brain": "scripted",
   "ok": false,
   "startedAt": 1781044993358,
   "meta": {
    "baseUrl": "http://127.0.0.1:4798"
   },
   "turns": [
    {
     "t": 1781044993358,
     "role": "user",
     "text": "Billing \u00b7 the free plan stops organization creation after 3"
    },
    {
     "t": 1781044993358,
     "role": "assistant",
     "kind": "reasoning",
     "text": "A fresh user creates organizations through the web UI until the free plan refuses \u2014 expecting 3 to succeed and the 4th to be blocked."
    },
    {
     "t": 1781044993988,
     "role": "step",
     "surface": "browser",
     "text": "Opened http://127.0.0.1:4798 as user_fcac1b81 (dark, 1280\u00d7800)"
    },
    {
     "t": 1781044999794,
     "role": "step",
     "surface": "browser",
     "text": "A fresh user lands on onboarding (no organization yet)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "01-a-fresh-user-lands-on-onboarding-no-organization-yet.png",
       "label": "A fresh user lands on onboarding (no organization yet)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 1,
       "endMs": 5807
      }
     ]
    },
    {
     "t": 1781045000249,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 1\u201d (1 of 3 allowed on the free plan)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "02-create-acme-1-1-of-3-allowed-on-the-free-plan.png",
       "label": "Create \u201cAcme 1\u201d (1 of 3 allowed on the free plan)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 5807,
       "endMs": 6262
      }
     ]
    },
    {
     "t": 1781045000681,
     "role": "step",
     "surface": "browser",
     "text": "Continue into the app",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "03-continue-into-the-app.png",
       "label": "Continue into the app"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 6262,
       "endMs": 6694
      }
     ]
    },
    {
     "t": 1781045001298,
     "role": "step",
     "surface": "browser",
     "text": "Open the org switcher and choose \u201cCreate organization\u201d",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "04-open-the-org-switcher-and-choose-create-organization.png",
       "label": "Open the org switcher and choose \u201cCreate organization\u201d"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 6694,
       "endMs": 7310
      }
     ]
    },
    {
     "t": 1781045002125,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 2\u201d (2 of 3)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "05-create-acme-2-2-of-3.png",
       "label": "Create \u201cAcme 2\u201d (2 of 3)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 7311,
       "endMs": 8138
      }
     ]
    },
    {
     "t": 1781045002596,
     "role": "step",
     "surface": "browser",
     "text": "Open the org switcher and choose \u201cCreate organization\u201d",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "06-open-the-org-switcher-and-choose-create-organization.png",
       "label": "Open the org switcher and choose \u201cCreate organization\u201d"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 8138,
       "endMs": 8609
      }
     ]
    },
    {
     "t": 1781045003368,
     "role": "step",
     "surface": "browser",
     "text": "Create \u201cAcme 3\u201d (3 of 3)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "07-create-acme-3-3-of-3.png",
       "label": "Create \u201cAcme 3\u201d (3 of 3)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 8609,
       "endMs": 9381
      }
     ]
    },
    {
     "t": 1781045004290,
     "role": "step",
     "surface": "browser",
     "text": "Attempt a 4th organization (over the free limit)",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "08-attempt-a-4th-organization-over-the-free-limit.png",
       "label": "Attempt a 4th organization (over the free limit)"
      },
      {
       "kind": "video",
       "path": "00-session.mp4",
       "startMs": 9381,
       "endMs": 10303
      }
     ]
    },
    {
     "t": 1781045005090,
     "role": "assert",
     "assertion": {
      "kind": "toBe",
      "actual": "Failed to create organization.",
      "expected": "",
      "ok": false,
      "label": "the upgraded plan should allow a 4th organization"
     }
    },
    {
     "t": 1781045005140,
     "role": "error",
     "text": "AssertionError: the upgraded plan should allow a 4th organization",
     "evidence": [
      {
       "kind": "screenshot",
       "path": "08-attempt-a-4th-organization-over-the-free-limit.png",
       "label": "at failure"
      }
     ]
    }
   ],
   "asserts": [
    {
     "kind": "toBe",
     "actual": "Failed to create organization.",
     "expected": "",
     "ok": false,
     "label": "the upgraded plan should allow a 4th organization"
    }
   ],
   "endedAt": 1781045004681,
   "durationMs": 11323,
   "assetBase": "../cloud/billing-the-free-plan-stops-organization-creation-after-3/",
   "error": "expect(\"Failed to create organization.\").toBe(\"\") \u2014 the 4th create should have succeeded after upgrade"
  }
 ],
 "manifest": {
  "generatedAt": 1781045012084,
  "runs": [
   {
    "scenario": "Tools \u00b7 every advertised tool is well-formed enough to call",
    "target": "selfhost",
    "slug": "tools-every-advertised-tool-is-well-formed-enough-to-call",
    "ok": true,
    "durationMs": 71,
    "endedAt": 1781045010855
   },
   {
    "scenario": "OpenAPI \u00b7 registering a spec exposes its operations as tools",
    "target": "selfhost",
    "slug": "openapi-registering-a-spec-exposes-its-operations-as-tools",
    "ok": true,
    "durationMs": 144,
    "endedAt": 1781045007173
   },
   {
    "scenario": "API \u00b7 typed client lists the available tools",
    "target": "selfhost",
    "slug": "api-typed-client-lists-the-available-tools",
    "ok": true,
    "durationMs": 524,
    "endedAt": 1781045006221
   },
   {
    "scenario": "Integrations \u00b7 a fresh workspace ships the built-in executor integration ready to use",
    "target": "selfhost",
    "slug": "integrations-a-fresh-workspace-ships-the-built-in-executor-integration-ready-to-",
    "ok": true,
    "durationMs": 91,
    "endedAt": 1781045008888
   },
   {
    "scenario": "MCP \u00b7 a paused execution resumes after human approval",
    "target": "selfhost",
    "slug": "mcp-a-paused-execution-resumes-after-human-approval",
    "ok": true,
    "durationMs": 233,
    "endedAt": 1781045008091
   },
   {
    "scenario": "API \u00b7 a fresh identity starts with zero connections",
    "target": "selfhost",
    "slug": "api-a-fresh-identity-starts-with-zero-connections",
    "ok": true,
    "durationMs": 59,
    "endedAt": 1781045006282
   },
   {
    "scenario": "MCP \u00b7 OAuth connect, then execute code in the sandbox",
    "target": "selfhost",
    "slug": "mcp-oauth-connect-then-execute-code-in-the-sandbox",
    "ok": true,
    "durationMs": 61,
    "endedAt": 1781045010094
   },
   {
    "scenario": "Policies \u00b7 a created policy appears in the list for the owning identity",
    "target": "selfhost",
    "slug": "policies-a-created-policy-appears-in-the-list-for-the-owning-identity",
    "ok": true,
    "durationMs": 89,
    "endedAt": 1781045009662
   },
   {
    "scenario": "Billing \u00b7 the free plan stops organization creation after 3",
    "target": "cloud",
    "slug": "billing-the-free-plan-stops-organization-creation-after-3",
    "ok": true,
    "durationMs": 11323,
    "endedAt": 1781045004681
   },
   {
    "scenario": "Organizations \u00b7 switching organizations switches the workspace",
    "target": "cloud",
    "slug": "organizations-switching-organizations-switches-the-workspace",
    "ok": true,
    "durationMs": 10717,
    "endedAt": 1781045004084
   },
   {
    "scenario": "Connect \u00b7 the agent-connect panel gives working copy for both transports",
    "target": "cloud",
    "slug": "connect-the-agent-connect-panel-gives-working-copy-for-both-transports",
    "ok": true,
    "durationMs": 7652,
    "endedAt": 1781045001022
   },
   {
    "scenario": "Tools \u00b7 every advertised tool is well-formed enough to call",
    "target": "cloud",
    "slug": "tools-every-advertised-tool-is-well-formed-enough-to-call",
    "ok": true,
    "durationMs": 206,
    "endedAt": 1781044994904
   },
   {
    "scenario": "OpenAPI \u00b7 registering a spec exposes its operations as tools",
    "target": "cloud",
    "slug": "openapi-registering-a-spec-exposes-its-operations-as-tools",
    "ok": true,
    "durationMs": 820,
    "endedAt": 1781044995767
   },
   {
    "scenario": "API \u00b7 typed client lists the available tools",
    "target": "cloud",
    "slug": "api-typed-client-lists-the-available-tools",
    "ok": true,
    "durationMs": 297,
    "endedAt": 1781044995044
   },
   {
    "scenario": "Integrations \u00b7 a fresh workspace ships the built-in executor integration ready to use",
    "target": "cloud",
    "slug": "integrations-a-fresh-workspace-ships-the-built-in-executor-integration-ready-to-",
    "ok": true,
    "durationMs": 453,
    "endedAt": 1781044995175
   },
   {
    "scenario": "API \u00b7 a fresh identity starts with zero connections",
    "target": "cloud",
    "slug": "api-a-fresh-identity-starts-with-zero-connections",
    "ok": true,
    "durationMs": 115,
    "endedAt": 1781044995161
   },
   {
    "scenario": "Policies \u00b7 a created policy appears in the list for the owning identity",
    "target": "cloud",
    "slug": "policies-a-created-policy-appears-in-the-list-for-the-owning-identity",
    "ok": true,
    "durationMs": 383,
    "endedAt": 1781044995101
   },
   {
    "scenario": "Onboarding \u00b7 the MCP setup step hands the user their org-scoped MCP server URL",
    "target": "cloud",
    "slug": "onboarding-the-mcp-setup-step-hands-the-user-their-org-scoped-mcp-server-url",
    "ok": true,
    "durationMs": 7445,
    "endedAt": 1781045000821
   }
  ],
  "skips": [
   {
    "scenario": "MCP \u00b7 OAuth connect, then execute code in the sandbox",
    "target": "cloud",
    "missing": [
     "mcp-oauth"
    ]
   }
  ]
 }
};
