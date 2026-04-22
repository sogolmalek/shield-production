window.addEventListener('message', async (event) => {
    if (event.data.type === 'SHIELD_REQ_CONNECT') {
        try {
            const provider = window.phantom?.solana || window.solana;
            if (!provider) return window.postMessage({ type: 'SHIELD_RES_CONNECT', error: 'No Phantom' }, '*');
            const resp = await provider.connect();
            window.postMessage({ type: 'SHIELD_RES_CONNECT', address: resp.publicKey.toString() }, '*');
        } catch (e) {
            window.postMessage({ type: 'SHIELD_RES_CONNECT', error: e.message }, '*');
        }
    }
});
