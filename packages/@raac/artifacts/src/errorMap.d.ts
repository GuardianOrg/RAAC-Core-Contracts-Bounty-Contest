
/**
 * Error input parameter definition for the error map
 */
export interface ErrorInput {
  name: string;
  type: string;
  internalType: string;
}

/**
 * Error definition for the error map
 */
export interface ErrorDefinition {
  name: string;
  signature: string;
  message: string;
  contract?: string;
  inputs?: ErrorInput[];
}


/**
 * Error map keyed by 4-byte selector (e.g., "0x6697b232")
 */
export interface ErrorMap {
  [selector: string]: ErrorDefinition;
}

/**
 * Error map for the error map
 */
declare const errorMap: ErrorMap;
export default errorMap;

