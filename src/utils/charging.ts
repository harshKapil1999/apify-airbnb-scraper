import { Actor } from 'apify';

/**
 * Attempts to charge for an event. If the charge fails (indicating insufficient credits or other critical error),
 * it aborts the entire actor run to prevent further credit usage or unauthorized scraping.
 * 
 * @param eventName The name of the event to charge for (e.g., 'listing-scraped')
 * @param count The number of events to charge
 */
export async function chargeOrAbort(eventName: string, count: number = 1): Promise<void> {
    if (count <= 0) return;

    try {
        await Actor.charge({ eventName, count });
    } catch (error) {
        console.error(`[CRITICAL] Failed to charge for event '${eventName}' (count: ${count}). Aborting actor run.`);
        console.error(error);

        // Fail the run immediately. This stops the actor and signals failure.
        // We use exit(1) to force a non-zero exit code if Actor.fail() is not enough or to be doubly sure.
        try {
            await Actor.fail(`Credit charge failed for event: ${eventName}. Stop reason: Insufficient credits or API error.`);
        } catch (e) {
            // If fail() throws, force exit
            process.exit(1);
        }
        process.exit(1);
    }
}
