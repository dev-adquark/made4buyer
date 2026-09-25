export default function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  const okMsg = Array.isArray(ok) ? ok[0] : ok;
  const errMsg = Array.isArray(error) ? error[0] : error;
  return (
    <>
      {okMsg && (
        <p className="notice ok toast" role="status">
          {okMsg}
        </p>
      )}
      {errMsg && (
        <p className="notice error toast" role="alert">
          {errMsg}
        </p>
      )}
    </>
  );
}
