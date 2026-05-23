import Link from "next/link";

import { PhilippinesOutlineIcon } from "@/components/philippines-outline-icon";

export default function NotFound() {
  return (
    <section className="not-found-shell">
      <div className="not-found-panel">
        <PhilippinesOutlineIcon className="not-found-mapmark" />
        <h1 className="not-found-title">Page Does not exist</h1>
        <Link href="/login" className="auth-message-link">
          Please Login Here
        </Link>
      </div>
    </section>
  );
}
