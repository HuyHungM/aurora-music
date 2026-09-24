import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));