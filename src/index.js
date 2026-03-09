// =============================================================================
// x402 Payment-Gated Resource Server — Cloudflare Worker
// =============================================================================
// Add routes below: { "/path": { price, contentType, content } }
// Routes not listed return 404.
// =============================================================================

const PRISM_GATEWAY = "https://prism-gw.fd.xyz";

const GATED_ROUTES = {
  "/premium/jokes/": {
    price: 0.01,
    contentType: "application/json",
    content: JSON.stringify({
      jokes: [
        { id: 1, joke: "Why do programmers prefer dark mode? Because light attracts bugs." },
        { id: 2, joke: "A SQL query walks into a bar and asks two tables: 'Can I join you?'" },
        { id: 3, joke: "Why did the developer go broke? Because he used up all his cache." },
      ]
    }),
  },
  "/premium/proof.txt": {
    price: 0.01,
    contentType: "text/plain",
    content: "If you're reading this, you made it.\nThis resource is proof that the request passed access control and reached the premium tier.",
  },
};

// =============================================================================

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const route = GATED_ROUTES[url.pathname];

  console.log(`[request] ${request.method} ${url.pathname}`);

  if (!route) {
    console.log(`[route] no match for ${url.pathname} — returning 404`);
    return new Response("Not found", { status: 404 });
  }

  const paymentHeader = request.headers.get("x-payment");
  console.log(`[payment-header] present=${!!paymentHeader}`);

  // No payment header — fetch requirements from Prism and return 402
  if (!paymentHeader) {
    console.log(`[requirements] fetching from Prism for route=${url.pathname} price=${route.price}`);
    const requirementsRes = await fetch(
      `${PRISM_GATEWAY}/api/v2/payment/requirements`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-api-key": env.PRISM_API_KEY,
        },
        body: JSON.stringify({
          resourceUrl: request.url,
          requestedAmount: route.price,
        }),
      }
    );

    const body = await requirementsRes.text();
    console.log(`[requirements] Prism responded status=${requirementsRes.status} body=${body}`);
    return new Response(body, {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Decode X-Payment header (base64 → JSON)
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
    console.log(`[decode] payment header decoded OK`);
  } catch (e) {
    console.log(`[decode] failed to decode payment header: ${e.message} raw=${paymentHeader}`);
    return new Response(
      JSON.stringify({ error: "Invalid X-Payment header encoding" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const paymentRequirements = paymentPayload?.accepted ?? null;
  console.log(`[verify] sending to Prism paymentRequirements=${JSON.stringify(paymentRequirements)}`);

  // Verify payment with Prism
  const verifyRes = await fetch(
    `${PRISM_GATEWAY}/api/v2/payment/verify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-api-key": env.PRISM_API_KEY,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    }
  );

  const verifyText = await verifyRes.text();
  console.log(`[verify] Prism responded status=${verifyRes.status} body=${verifyText}`);
  if (!verifyRes.ok) {
    console.log(`[verify] non-OK status from Prism, returning error to caller`);
    return new Response(verifyText, {
      status: verifyRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const verifyBody = (() => { try { return JSON.parse(verifyText); } catch { return null; } })();
  if (verifyBody?.isValid !== true) {
    console.log(`[verify] isValid=false reason=${verifyBody?.invalidReason}`);
    return new Response(JSON.stringify({
      error: "payment_verification_failed",
      reason: verifyBody?.invalidReason ?? "unknown",
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.log(`[verify] payment valid — proceeding to settle`);

  // Settle payment with Prism
  console.log(`[settle] sending to Prism`);
  const settleRes = await fetch(
    `${PRISM_GATEWAY}/api/v2/payment/settle`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-api-key": env.PRISM_API_KEY,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    }
  );

  const settleText = await settleRes.text();
  console.log(`[settle] Prism responded status=${settleRes.status} body=${settleText}`);
  if (!settleRes.ok) {
    console.log(`[settle] non-OK status from Prism, returning error to caller`);
    return new Response(settleText, {
      status: settleRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const settleBody = (() => { try { return JSON.parse(settleText); } catch { return null; } })();
  if (settleBody?.success !== true) {
    console.log(`[settle] success=false reason=${settleBody?.errorReason}`);
    return new Response(JSON.stringify({
      error: "payment_settlement_failed",
      reason: settleBody?.errorReason ?? "unknown",
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.log(`[settle] payment settled — serving content for route=${url.pathname}`);

  // Payment verified + settled — return content directly
  return new Response(route.content, {
    status: 200,
    headers: {
      "Content-Type": route.contentType,
      "Cache-Control": "no-store",
    },
  });
}
