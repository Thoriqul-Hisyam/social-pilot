/**
 * The SocialPilot mark, "Si Pilot": a round face in a classic aviator cap with ear flaps,
 * the pilot who keeps the queue flying. Drawn in currentColor on a 64-unit grid, so it takes
 * the color of wherever it sits; the eyes are cut out of the face.
 */
export const BrandMark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="currentColor" aria-hidden>
    <path d="M4 31A28 28 0 0 1 60 31V44A6 6 0 0 1 54 50H52.5V35.5Q32 25 11.5 35.5V50H10A6 6 0 0 1 4 44Z" />
    <path fillRule="evenodd" d="M14.06 35.49Q32 29.51 49.94 35.49A18.5 18.5 0 1 1 14.06 35.49ZM21 45a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0ZM34 45a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0Z" />
  </svg>
)
