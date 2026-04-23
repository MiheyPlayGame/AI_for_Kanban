import React from "react";
import eyeOffUrl from "../assets/icons/Eye off.svg?url";
import eyeUrl from "../assets/icons/Eye.svg?url";

type AuthPasswordEyeIconProps = {
  /** True when the password field is showing plain text (use “eye off” icon). */
  revealed: boolean;
};

export function AuthPasswordEyeIcon({ revealed }: AuthPasswordEyeIconProps) {
  return (
    <img
      src={revealed ? eyeOffUrl : eyeUrl}
      alt=""
      width={20}
      height={20}
      className="auth-password-toggle-icon"
    />
  );
}
