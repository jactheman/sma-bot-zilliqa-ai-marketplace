#!/usr/bin/env node
// Entry point: registers tsx so the CLI and your TypeScript strategies run without a build step.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
