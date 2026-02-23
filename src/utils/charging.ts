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
    } catch (error: any) {
        const errorMessage = error?.message || '';
        const isCreditError = errorMessage.toLowerCase().includes('credit') ||
            errorMessage.toLowerCase().includes('balance') ||
            errorMessage.toLowerCase().includes('exhausted');

        const failureMessage = isCreditError
            ? `User credits exhausted. Component: ${eventName}. Please top up your Apify account to continue.`
            : `Credit charge failed for event: ${eventName}. Stop reason: Insufficient credits or API error. Detail: ${errorMessage}`;

        console.error(`[CRITICAL] ${failureMessage}`);
        console.error(error);

        // Fail the run immediately. This stops the actor and signals failure.
        try {
            await Actor.fail(failureMessage);
        } catch (e) {
            // If fail() throws, force exit
            process.exit(1);
        }
        process.exit(1);
    }
}
