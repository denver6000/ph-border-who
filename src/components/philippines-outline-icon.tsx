type PhilippinesOutlineIconProps = {
  className?: string;
};

export function PhilippinesOutlineIcon({ className = "login-mapmark" }: PhilippinesOutlineIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 420 760"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M192 40L229 73L222 118L247 168L229 208L250 260L221 298L235 350L205 397L218 447L182 488L200 547L169 602L183 664L150 720"
        className="login-mapmark-stroke"
      />
      <path
        d="M169 88L146 116L155 154L124 193L141 239L112 284L130 330L110 374L121 420"
        className="login-mapmark-stroke"
      />
      <path
        d="M247 118L289 149L281 194L304 236L286 281L309 333L278 379"
        className="login-mapmark-stroke"
      />
      <path
        d="M160 451L132 497L146 553L114 600L129 657"
        className="login-mapmark-stroke"
      />
      <path
        d="M231 466L272 509L261 567L291 621L272 685L292 729"
        className="login-mapmark-stroke"
      />
      <path
        d="M175 263L196 281L186 309L210 330L193 362"
        className="login-mapmark-stroke"
      />
      <circle cx="224" cy="77" r="10" className="login-mapmark-dot" />
      <circle cx="154" cy="154" r="8" className="login-mapmark-dot" />
      <circle cx="284" cy="191" r="8" className="login-mapmark-dot" />
      <circle cx="205" cy="489" r="8" className="login-mapmark-dot" />
      <circle cx="153" cy="603" r="8" className="login-mapmark-dot" />
      <circle cx="276" cy="621" r="8" className="login-mapmark-dot" />
    </svg>
  );
}
