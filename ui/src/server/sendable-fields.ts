/**
 * What a browser may hand to `sendMessage`: the message's own fields, the marks and the effort a person asks for,
 * nothing else. Options that belong to the server (`tags`) and anything else in the JSON are dropped, so a caller
 * cannot switch off the @tag rule for their own message. `effort` passes: the adapter refuses it from a sender who
 * is not a human member (the compose box only offers it to one).
 */
export function sendableFields(msg: Record<string, unknown>) {
	const { from, to, cc, subject, body, replyTo, projectCode, attachments, questions, answers, fyi, expectsReply, effort } = msg;
	return { from, to, cc, subject, body, replyTo, projectCode, attachments, questions, answers, fyi, expectsReply, effort };
}
