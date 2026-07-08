import { makeInProcessAppToolExecutor } from "./app-tool-executor";
import { appToolExecutorConformance } from "../testing/conformance";

appToolExecutorConformance("in-process", makeInProcessAppToolExecutor);
