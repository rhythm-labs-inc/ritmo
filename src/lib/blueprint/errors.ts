/** Stable validation detail for a Blueprint input. */
export interface BlueprintValidationIssue {
  path: string
  message: string
}

/** Raised when an input cannot be parsed as the requested Blueprint version. */
export class BlueprintValidationError extends Error {
  constructor(public readonly issues: BlueprintValidationIssue[]) {
    super(`Invalid Plugin Blueprint (${issues.length} error${issues.length === 1 ? '' : 's'})`)
    this.name = 'BlueprintValidationError'
  }
}

/** Raised when no registered migration can reach the current Blueprint version. */
export class BlueprintMigrationError extends Error {
  constructor(
    public readonly fromVersion: number | undefined,
    public readonly targetVersion: number,
  ) {
    super(
      fromVersion === undefined
        ? `Blueprint schema_version is required; expected ${targetVersion}.`
        : `No migration is registered from Blueprint schema_version ${fromVersion} to ${targetVersion}.`,
    )
    this.name = 'BlueprintMigrationError'
  }
}

/** Raised when a Blueprint document cannot be read, parsed, or migrated. */
export class BlueprintLoadError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'BlueprintLoadError'
  }
}

/** Raised when a valid Blueprint cannot be represented by a selected adapter. */
export class BlueprintProjectionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'BlueprintProjectionError'
  }
}
