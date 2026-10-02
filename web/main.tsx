import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "./style.css";
import { App } from "./App.js";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      theme={{
        primaryColor: "dark",
        primaryShade: 7,
        defaultRadius: "md",
        fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "20px" },
        headings: { fontWeight: "600" },
        components: Object.fromEntries(["Button", "TextInput", "Textarea", "Select", "Autocomplete", "Checkbox"].map(name => [name, { defaultProps: { size: "sm" } }])),
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
