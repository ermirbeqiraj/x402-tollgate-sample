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

  if (!route) {
    return new Response("Not found", { status: 404 });
  }

  const paymentHeader = request.headers.get("x-payment");

  // No payment header — fetch requirements from Prism and return 402
  if (!paymentHeader) {
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
    return new Response(body, {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Decode X-Payment header (base64 → JSON)
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid X-Payment header encoding" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const paymentRequirements = paymentPayload?.accepted ?? null;

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
  if (!verifyRes.ok) {
    return new Response(verifyText, {
      status: verifyRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const verifyBody = (() => { try { return JSON.parse(verifyText); } catch { return null; } })();
  if (verifyBody?.isValid !== true) {
    return new Response(JSON.stringify({
      error: "payment_verification_failed",
      reason: verifyBody?.invalidReason ?? "unknown",
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Settle payment with Prism
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
  if (!settleRes.ok) {
    return new Response(settleText, {
      status: settleRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const settleBody = (() => { try { return JSON.parse(settleText); } catch { return null; } })();
  if (settleBody?.isValid !== true) {
    return new Response(JSON.stringify({
      error: "payment_settlement_failed",
      reason: settleBody?.invalidReason ?? "unknown",
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Payment verified + settled — return content directly
  return new Response(route.content, {
    status: 200,
    headers: {
      "Content-Type": route.contentType,
      "Cache-Control": "no-store",
    },
  });
}
