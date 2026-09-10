import { buildOmpConfig, parseOmpStdoutLine } from "@paperclipai/adapter-omp-local/ui";
import type { UIAdapterModule } from "../types";
import { OmpLocalConfigFields } from "./config-fields";

export const ompLocalUIAdapter: UIAdapterModule = {
  type: "omp_local",
  label: "OMP",
  parseStdoutLine: parseOmpStdoutLine,
  ConfigFields: OmpLocalConfigFields,
  buildAdapterConfig: buildOmpConfig,
};
