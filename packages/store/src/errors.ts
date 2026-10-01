/** Thrown by writes that target a record that does not exist (or has expired). */
export class NotFoundError extends Error {
  constructor(message = 'record not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
