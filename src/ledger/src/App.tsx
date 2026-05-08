import { useState } from "react";
import "./App.css";

const MARABU_UNIT = 10 ** 12;

interface UtxoEntry {
  txid: string;
  index: number;
  value: number;
}

interface UtxosResponse {
  utxos: UtxoEntry[];
  error?: string;
}

interface TxResponse {
  status: string;
  txid: string;
  error?: string;
}

interface TxOutput {
  pubkey: string;
  value: number;
}

type Step = "form" | "review";

function toMarabu(picabu: number): string {
  return (picabu / MARABU_UNIT).toString();
}

function fromMarabu(marabu: string): number {
  const n = parseFloat(marabu);
  return isNaN(n) ? 0 : Math.round(n * MARABU_UNIT);
}

function App() {
  const [pubkey, setPubkey] = useState("");
  const [utxos, setUtxos] = useState<UtxoEntry[] | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<TxOutput[]>([{ pubkey: "", value: 0 }]);
  const [step, setStep] = useState<Step>("form");
  const [selectedUtxos, setSelectedUtxos] = useState<UtxoEntry[]>([]);
  const [change, setChange] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAddOutput = () => setOutputs([...outputs, { pubkey: "", value: 0 }]);

  const handleOutputChange = (i: number, field: keyof TxOutput, val: string) => {
    setOutputs((prev) =>
      prev.map((o, idx) => {
        if (idx !== i) return o;
        if (field === "pubkey") return { ...o, pubkey: val };
        return { ...o, value: fromMarabu(val) };
      }),
    );
  };

  const handleRemoveOutput = (i: number) => setOutputs(outputs.filter((_, idx) => idx !== i));

  const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0);

  const fetchUtxos = async () => {
    setError("");
    if (!pubkey.trim()) return setError("Enter your pubkey.");
    setLoading(true);
    try {
      const res = await fetch(`/utxos?pubkey=${encodeURIComponent(pubkey)}`);
      const data: UtxosResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch UTXOs");
      setUtxos(data.utxos);
      setBalance(data.utxos.reduce((s, u) => s + u.value, 0));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    }
    setLoading(false);
  };

  const autoSelect = (available: UtxoEntry[], target: number) => {
    const sorted = [...available].sort((a, b) => b.value - a.value);
    const selected: UtxoEntry[] = [];
    let sum = 0;
    for (const u of sorted) {
      if (sum >= target) break;
      selected.push(u);
      sum += u.value;
    }
    return { selected, sum, change: sum - target };
  };

  const handleSubmit = () => {
    setError("");
    if (!utxos) return setError("Check your balance first.");
    if (outputs.length === 0 || outputs.some((o) => !o.pubkey || o.value <= 0))
      return setError("All outputs need pubkey and value > 0.");

    const result = autoSelect(utxos, totalOutput);
    if (result.sum < totalOutput) {
      setError(
        `Insufficient funds. Need ${toMarabu(totalOutput)} bu, have ${toMarabu(result.sum)}.`,
      );
      return;
    }

    setSelectedUtxos(result.selected);
    setChange(result.change);
    setStep("review");
  };

  const handleConfirm = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/tx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "transaction",
          inputs: selectedUtxos.map((u) => ({
            outpoint: { txid: u.txid, index: u.index },
            sig: null,
          })),
          outputs: [...outputs, ...(change > 0 ? [{ pubkey, value: change }] : [])],
        }),
      });
      const data: TxResponse = await res.json();
      console.log("TX result:", data);
      setOutputs([{ pubkey: "", value: 0 }]);
      setStep("form");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    }
    setLoading(false);
  };

  const handleBack = () => {
    setStep("form");
    setError("");
  };

  const balanceMarabu = balance !== null ? balance / MARABU_UNIT : null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Hero */}
      <header className="bg-linear-to-br from-purple-900 via-slate-900 to-slate-950 py-8 px-6 text-center border-b border-purple-500/20">
        <h1 className="text-5xl md:text-7xl font-bold text-white tracking-tight mb-4">
          Marabu Ledger
        </h1>
      </header>

      {/* Balance */}
      <section className="bg-slate-900/50 border-b border-slate-800 p-4">
        <div className="max-w-md mx-auto flex items-center flex-col">
          <span className="text-slate-400 font-medium">Balance</span>
          <span className="text-3xl font-bold text-white tabular-nums">
            {balanceMarabu !== null ? (
              <>
                {balanceMarabu.toFixed(2)}{" "}
                <span className="text-lg text-purple-400 font-normal">bu</span>
              </>
            ) : (
              <span className="text-lg text-slate-600 font-normal">enter pubkey &amp; check</span>
            )}
          </span>
        </div>
        {balance !== null && (
          <p className="text-xs text-slate-600 text-center mt-4">
            {balance.toLocaleString()} picabu
          </p>
        )}
      </section>

      {/* Main */}
      <section className="flex-1 px-6 py-10">
        <div className="max-w-2xl mx-auto">
          {step === "form" ? (
            <>
              <h2 className="text-2xl font-semibold text-white mb-8">New Transaction</h2>

              <div className="space-y-8">
                {/* Pubkey (sender) */}
                <div>
                  <label className="text-sm font-medium text-slate-400 block mb-1">
                    Your pubkey
                  </label>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 font-mono"
                      placeholder="hex public key (64 chars)"
                      value={pubkey}
                      onChange={(e) => setPubkey((e.target as HTMLInputElement).value)}
                    />
                    <button
                      type="button"
                      onClick={fetchUtxos}
                      disabled={loading || !pubkey.trim()}
                      className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {loading ? "..." : "Check"}
                    </button>
                  </div>
                </div>

                {/* UTXO list */}
                {utxos !== null && (
                  <div className="border border-slate-700 rounded-xl p-5">
                    <h3 className="text-sm font-medium text-slate-400 mb-3">
                      Your UTXOs ({utxos.length})
                    </h3>
                    {utxos.length === 0 ? (
                      <p className="text-xs text-slate-600 italic">No UTXOs for this pubkey.</p>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {utxos.map((u) => (
                          <div
                            key={`${u.txid}:${u.index}`}
                            className="flex justify-between text-sm bg-slate-800/50 rounded-lg px-3 py-2"
                          >
                            <span className="text-slate-400 font-mono text-xs truncate max-w-50">
                              {u.txid.slice(0, 16)}...:{u.index}
                            </span>
                            <span className="text-white font-mono text-xs">
                              {toMarabu(u.value)} bu
                            </span>
                            <span className="text-slate-600 text-[10px]">
                              ({u.value.toLocaleString()} picabu)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Outputs */}
                <fieldset className="border border-slate-700 rounded-xl p-5">
                  <legend className="text-sm font-medium text-slate-400 px-2 flex items-center gap-2">
                    Send to
                    <button
                      type="button"
                      onClick={handleAddOutput}
                      className="text-purple-400 hover:text-purple-300 text-xs font-bold"
                    >
                      + Add
                    </button>
                  </legend>
                  <div className="space-y-4">
                    {outputs.map((out, i) => (
                      <div key={i} className="flex flex-col sm:flex-row gap-3 items-start">
                        <input
                          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 font-mono"
                          placeholder="pubkey (hex)"
                          value={out.pubkey}
                          onChange={(e) =>
                            handleOutputChange(i, "pubkey", (e.target as HTMLInputElement).value)
                          }
                        />
                        <div className="flex items-center gap-2 w-full sm:w-auto">
                          <input
                            className="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 font-mono"
                            type="text"
                            inputMode="numeric"
                            placeholder="bu"
                            value={toMarabu(out.value) || ""}
                            onChange={(e) =>
                              handleOutputChange(i, "value", (e.target as HTMLInputElement).value)
                            }
                          />
                          <span className="text-xs text-slate-600">bu</span>
                          {outputs.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveOutput(i)}
                              className="text-red-500 hover:text-red-400 text-xs ml-1"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {outputs.length > 0 && totalOutput > 0 && (
                    <p className="text-xs text-slate-500 mt-3">
                      Total:{" "}
                      <span className="text-slate-300 font-mono">{toMarabu(totalOutput)} bu</span>{" "}
                      <span className="text-slate-600">
                        ({totalOutput.toLocaleString()} picabu)
                      </span>
                    </p>
                  )}
                </fieldset>

                {/* Error */}
                {error && (
                  <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2">
                    {error}
                  </p>
                )}

                {/* Submit */}
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={loading || !utxos}
                  className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors cursor-pointer"
                >
                  Review Transaction
                </button>
              </div>
            </>
          ) : (
            /* Review step */
            <>
              <h2 className="text-2xl font-semibold text-white mb-8">Review Transaction</h2>

              <div className="space-y-6">
                {/* Selected inputs */}
                <div className="border border-slate-700 rounded-xl p-5">
                  <h3 className="text-sm font-medium text-slate-400 mb-3">
                    Selected Inputs ({selectedUtxos.length})
                  </h3>
                  <div className="space-y-2">
                    {selectedUtxos.map((u) => (
                      <div
                        key={`${u.txid}:${u.index}`}
                        className="flex justify-between text-sm bg-slate-800/50 rounded-lg px-3 py-2"
                      >
                        <span className="text-slate-400 font-mono text-xs truncate max-w-50">
                          {u.txid.slice(0, 16)}...:{u.index}
                        </span>
                        <span className="text-white font-mono">
                          {u.value.toLocaleString()} picabu
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-3">
                    Total input:{" "}
                    <span className="text-slate-300 font-mono">
                      {toMarabu(selectedUtxos.reduce((s, u) => s + u.value, 0))} bu
                    </span>{" "}
                    <span className="text-slate-600">
                      ({selectedUtxos.reduce((s, u) => s + u.value, 0).toLocaleString()} picabu)
                    </span>
                  </p>
                </div>

                {/* Outputs */}
                <div className="border border-slate-700 rounded-xl p-5">
                  <h3 className="text-sm font-medium text-slate-400 mb-3">Recipients</h3>
                  <div className="space-y-2">
                    {outputs.map((o, i) => (
                      <div
                        key={i}
                        className="flex justify-between text-sm bg-slate-800/50 rounded-lg px-3 py-2"
                      >
                        <span className="text-slate-400 font-mono text-xs truncate max-w-50">
                          {o.pubkey.slice(0, 16)}...
                        </span>
                        <span className="text-white font-mono text-xs">{toMarabu(o.value)} bu</span>
                        <span className="text-slate-600 text-[10px]">
                          ({o.value.toLocaleString()} picabu)
                        </span>
                      </div>
                    ))}
                    {change > 0 && (
                      <div className="flex justify-between text-sm bg-slate-800/50 rounded-lg px-3 py-2">
                        <span className="text-slate-500 font-mono text-xs">
                          Change (back to you)
                        </span>
                        <span className="text-purple-400 font-mono">{toMarabu(change)} bu</span>
                        <span className="text-slate-600 text-[10px]">
                          ({change.toLocaleString()} picabu)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2">
                    {error}
                  </p>
                )}

                {/* Actions */}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleBack}
                    disabled={loading}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold py-3 rounded-xl transition-colors cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={loading}
                    className="flex-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors cursor-pointer"
                  >
                    {loading ? "Sending..." : "Confirm & Send"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export default App;
