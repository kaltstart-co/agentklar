import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "./style.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      defaultColorScheme="auto"
      theme={createTheme({
        primaryColor: "indigo",
        defaultRadius: "md",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        headings: { fontWeight: "600" },
      })}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
