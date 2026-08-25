'use strict';
// Small helper: HTTP-level error with a Persian message.
class GameError extends Error {
  constructor(status, faMessage, extra) {
    super(faMessage);
    this.status = status;
    this.faMessage = faMessage;
    if (extra) Object.assign(this, extra);
  }
}

module.exports = { GameError };
