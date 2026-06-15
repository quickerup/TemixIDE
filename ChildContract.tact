// ============================================================
// GASLESS CHILD CONTRACT TEMPLATE
// - Uses a Public Key instead of an Address for ownership
// - Allows Relayers to pay TON gas on behalf of the user
// - Validates Ed25519 signatures for execution
// ============================================================

import "@stdlib/deploy";

// ── Messages ────────────────────────────────────────────────

// The actual payload the user wants to execute
struct ExecuteIntent {
    amountToWithdraw: Int as coins;
    destination: Address;           // Who gets the TON
    relayerReward: Int as coins;    // Fee paid to the relayer
    customPayload: Cell?;           // Arbitrary data
}

// The Meta-Transaction envelope sent by the Relayer
message MetaExecute {
    signature: Slice;             // 512-bit Ed25519 signature
    validUntil: Int as uint64;    // Deadline timestamp
    nonce: Int as uint64;         // Replay protection
    intent: ExecuteIntent;        // The struct the user signed
}

// ── Child Contract ───────────────────────────────────────────

contract ChildContract {

    // The Ed25519 public key of the owner (packed off-chain by client)
    ownerKey: Int;
    
    // Nonce to prevent replay attacks of the same signature
    nonce: Int as uint64;

    // Current TON balance of this child contract
    balance: Int as coins;

    // The factory injects the StateInit. This init MUST match the client's off-chain build.
    init(ownerKey: Int) {
        self.ownerKey = ownerKey;
        self.nonce = 0;
        self.balance = 0;
    }

    // Accept TON deposits
    receive() {
        self.balance += context().value;
    }

    // ── GASLESS EXECUTION (Meta-Transaction) ─────────────────
    // A Relayer (anyone) calls this and pays the native TON gas.
    // The contract verifies the owner's signature before executing.

    receive(msg: MetaExecute) {
        // 1. Validate expiration and nonce
        require(now() <= msg.validUntil, "Transaction expired");
        require(msg.nonce == self.nonce, "Invalid nonce");

        // 2. Reconstruct the hash the user signed
        // The user must sign: hash(nonce + validUntil + intent)
        let hashToVerify: Int = beginCell()
            .storeUint(msg.nonce, 64)
            .storeUint(msg.validUntil, 64)
            .storeCoins(msg.intent.amountToWithdraw)
            .storeAddress(msg.intent.destination)
            .storeCoins(msg.intent.relayerReward)
            .endCell()
            .hash();

        // 3. Verify the signature against the stored public key
        require(checkSignature(hashToVerify, msg.signature, self.ownerKey), "Invalid signature");

        // 4. Increment nonce to prevent replay
        self.nonce += 1;

        // 5. Calculate total cost (withdraw + reward)
        let totalCost: Int = msg.intent.amountToWithdraw + msg.intent.relayerReward;
        require(self.balance >= totalCost, "Insufficient balance in ChildContract");
        self.balance -= totalCost;

        // 6. Pay the Relayer (incentive)
        if (msg.intent.relayerReward > 0) {
            send(SendParameters{
                to: sender(),
                value: msg.intent.relayerReward,
                mode: SendIgnoreErrors,
                bounce: false,
                body: "Relayer Reward".asComment()
            });
        }

        // 7. Execute Withdrawal
        if (msg.intent.amountToWithdraw > 0) {
            send(SendParameters{
                to: msg.intent.destination,
                value: msg.intent.amountToWithdraw,
                mode: SendPayGasSeparately,
                bounce: true,
                body: "Gasless Withdrawal".asComment()
            });
        }
    }

    // ── Getters ──────────────────────────────────────────────

    get fun ownerKey(): Int { return self.ownerKey; }
    get fun nonce(): Int { return self.nonce; }
    get fun balance(): Int { return self.balance; }
}
