/**
 * Host-side proxy: fetches URLs using the HOST's own browser/internet connection.
 * This is the core of AetherGrid — clients request URLs, and the host fetches
 * them using its own internet and sends back the response via WebRTC DataChannel.
 * 
 * NO server/edge function involved — traffic flows directly through the host's connection.
 */

export async function hostFetchUrl(url: string): Promise<{ body: string; status: number; contentType: string }> {
  try {
    // Use the host's own browser fetch — this uses the HOST's internet connection
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      // Follow redirects
      redirect: 'follow',
      // No CORS mode — we want to fetch any URL
      mode: 'cors',
    });

    const contentType = response.headers.get('content-type') || 'text/plain';
    
    // For binary content types, we skip (too large for DataChannel usually)
    if (contentType.includes('image/') || contentType.includes('video/') || contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
      return {
        body: `[Binary content: ${contentType} — ${response.headers.get('content-length') || 'unknown'} bytes]`,
        status: response.status,
        contentType: 'text/plain',
      };
    }

    const body = await response.text();
    return { body, status: response.status, contentType };
  } catch (err) {
    // CORS errors are common when fetching from browser directly
    // Return a helpful message
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('CORS') || message.includes('NetworkError') || message.includes('Failed to fetch')) {
      // Throw so caller can fall back to edge function proxy
      throw new Error(`CORS_BLOCKED:${message}`);
    }
    
    throw err;
  }
}
