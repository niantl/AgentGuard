--------------------------- MODULE agentguard ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

(*
 * AgentGuard v3 Formal Specification
 * Models the reserve -> approve -> commit/release state machine and budget invariants.
 *)

CONSTANTS
    MaxAmount,            \* Total budget cap in paisa
    ApprovalThreshold,    \* Threshold above which human approval is required
    Transactions          \* Set of transaction IDs

VARIABLES
    consumedAmount,       \* Total committed spend
    reservedAmount,       \* Total currently in-flight reserved amount
    txStatus,             \* Status per transaction: "UNSUBMITTED", "PENDING", "AWAITING_APPROVAL", "COMMITTED", "RELEASED", "BLOCKED"
    txQuote               \* Quoted amount for each transaction

TypeOK ==
    /\ consumedAmount \in Nat
    /\ reservedAmount \in Nat
    /\ txStatus \in [Transactions -> {"UNSUBMITTED", "PENDING", "AWAITING_APPROVAL", "COMMITTED", "RELEASED", "BLOCKED"}]
    /\ txQuote \in [Transactions -> Nat]

Init ==
    /\ consumedAmount = 0
    /\ reservedAmount = 0
    /\ txStatus = [t \in Transactions |-> "UNSUBMITTED"]
    /\ txQuote = [t \in Transactions |-> 0]

(* Step 4: Reserve phase with per-transaction and cumulative checks *)
ProposeAndReserve(t, quote) ==
    /\ txStatus[t] = "UNSUBMITTED"
    /\ quote > 0
    /\ txQuote' = [txQuote EXCEPT ![t] = quote]
    /\ IF quote > MaxAmount \/ (consumedAmount + reservedAmount + quote > MaxAmount)
       THEN /\ txStatus' = [txStatus EXCEPT ![t] = "BLOCKED"]
            /\ UNCHANGED <<consumedAmount, reservedAmount>>
       ELSE IF quote > ApprovalThreshold
            THEN /\ txStatus' = [txStatus EXCEPT ![t] = "AWAITING_APPROVAL"]
                 /\ reservedAmount' = reservedAmount + quote
                 /\ UNCHANGED <<consumedAmount>>
            ELSE /\ txStatus' = [txStatus EXCEPT ![t] = "PENDING"]
                 /\ reservedAmount' = reservedAmount + quote
                 /\ UNCHANGED <<consumedAmount>>

(* Human Approves Escalation *)
Approve(t) ==
    /\ txStatus[t] = "AWAITING_APPROVAL"
    /\ txStatus' = [txStatus EXCEPT ![t] = "PENDING"]
    /\ UNCHANGED <<consumedAmount, reservedAmount, txQuote>>

(* Human Denies Escalation or Timeout occurs -> Release *)
DenyOrTimeout(t) ==
    /\ (txStatus[t] = "AWAITING_APPROVAL" \/ txStatus[t] = "PENDING")
    /\ reservedAmount >= txQuote[t]
    /\ txStatus' = [txStatus EXCEPT ![t] = "RELEASED"]
    /\ reservedAmount' = reservedAmount - txQuote[t]
    /\ UNCHANGED <<consumedAmount, txQuote>>

(* Step 6: Commit transaction after gateway success *)
Commit(t) ==
    /\ txStatus[t] = "PENDING"
    /\ reservedAmount >= txQuote[t]
    /\ txStatus' = [txStatus EXCEPT ![t] = "COMMITTED"]
    /\ reservedAmount' = reservedAmount - txQuote[t]
    /\ consumedAmount' = consumedAmount + txQuote[t]
    /\ UNCHANGED <<txQuote>>

Next ==
    \/ \E t \in Transactions, q \in 1..MaxAmount : ProposeAndReserve(t, q)
    \/ \E t \in Transactions : Approve(t)
    \/ \E t \in Transactions : DenyOrTimeout(t)
    \/ \E t \in Transactions : Commit(t)

Spec == Init /\ [][Next]_<<consumedAmount, reservedAmount, txStatus, txQuote>>

-----------------------------------------------------------------------------
(* INVARIANTS *)

(* Invariant 1: Budget Cap is NEVER exceeded by committed + in-flight exposure *)
BudgetSafetyInvariant ==
    consumedAmount + reservedAmount <= MaxAmount

(* Invariant 2: Non-negative balances *)
NoNegativeBalanceInvariant ==
    /\ consumedAmount >= 0
    /\ reservedAmount >= 0

=============================================================================
